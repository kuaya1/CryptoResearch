# Read-only wallet sync (2026-10-07)

Status: built and tested with fictional fixtures; committed and pushed to `main` on Eric's request (2026-10-07), so Render deploys it. Inert on every desk until a Moralis key (`MORALIS_API_KEY`) and a tracked wallet are both present: no wallet is tracked anywhere yet.

## Goal

Eric adds a public wallet address once (label, address, networks). The online desk then follows that address on its own schedule, so the Portfolio shows what the wallet holds after a buy, sale or transfer, even with the PC and browser closed. Read-only: no seed phrase, private key, signature, approval or spending permission is ever asked for or possible.

## Decisions

**Provider: Moralis (Web3 Data API v2.2), one provider.** Checked against Moralis's documentation on 2026-10-07:

- `GET /wallets/{address}/history` (150 CU a page): decoded transactions with `category` (send, receive, token send, token receive, token swap, deposit, withdraw, airdrop, mint, burn, borrow, contract interaction, nft …), `receipt_status`, `transaction_fee`, `possible_spam`, `native_transfers` and `erc20_transfers` (with `log_index`, raw `value`, `token_decimals`). Cursor pagination; `from_date`/`to_date` bound a window.
- `GET /wallets/{address}/tokens` (100 CU a page): balances with `native_token`, raw `balance`, `decimals`, `possible_spam`, `verified_contract`. Cursor pagination.
- `X-API-Key` header. Throughput limits per plan over a rolling 4-second window; 429 when exceeded (no Retry-After documented; one is honored when sent).
- Neither endpoint is on Moralis's planned-deprecation list. The history page now suggests Data Feeds as an alternative; the REST endpoint is still documented.
- Alchemy was not chosen: its Transfers API returns raw transfers only (no swap category, spam flag, receipt status or fee), which is what the classification needs, and its data APIs are not on its free plan either. Nothing about Eric's networks favors it.
- Cost: Moralis's own pricing page (2026-10-07) lists Starter at $149 a month with 2,000,000 CU; third-party listings still describe a free plan of 40,000 CU a day. The desk enforces a daily CU budget (default 40,000) so a plan is never overrun silently.

**Records: files, not Supabase.** The ledger (`portfolio/transactions.json`) stays the one authoritative record of holdings and cost. The wallet store under `portfolio/wallets/` is the authoritative record of what the provider reported (events with their raw provider items, balance snapshots) and of what Eric chose to track. Reconciliation is derived at read time. Supabase would add a second authoritative store, a network dependency and a place for addresses to leak, with no gain: the records already live on the Render disk, in sealed backups, packages and offsite copies (everything under `portfolio/` is included). No migration was written.

| Record | Where | Authority |
|---|---|---|
| Tracked wallets (label, public address, networks, status, linked ledger account) | `portfolio/wallets/registry.json` | authoritative (Eric's choices) |
| Events per wallet and network (each transfer leg, fee, classification, state, ledger link) | `portfolio/wallets/<wallet>/<network>/events.json` | authoritative (provider evidence) |
| Original provider items, by month | `portfolio/wallets/<wallet>/<network>/raw/<YYYY-MM>.json` | authoritative (audit) |
| Balance snapshots (last complete + recent) | `portfolio/wallets/<wallet>/<network>/balances.json` | authoritative (observation) |
| Sync progress, cursors, gate, CU counts | `portfolio/wallets/sync-state.json` | operational status |
| Ledger entries made from events | `portfolio/transactions.json` (`source: wallet_sync`) | authoritative ledger |
| Reconciliation, holdings view | computed on read | derived |

**Ledger semantics kept.** Only final, successful, supported events with a verified asset mapping become ledger entries: incoming transfer → `transfer_in` (cost unknown), outgoing transfer → `transfer_out`, transfer between two tracked wallets → a `transfer_out`/`transfer_in` pair with one `transfer_id`, a one-in/one-out swap → `sell` + `buy` at unknown price, gas → `fee` in the native coin. A first balance snapshot creates nothing in the ledger. Bridges, staking, liquidity, multi-leg swaps, mints, NFTs and unknown categories stay unresolved. An account with transactions Eric recorded himself for the same asset holds the import for his decision. Spam, failed transfers and reverted events never reach the ledger; a reorganized event that was already recorded is voided with the reason.

## Scope of this pass

- `dashboard/core/moralis.js` (adapter), `dashboard/core/wallets.js` (registry, events, classification, ledger import, reconciliation, overview), `dashboard/core/walletsync.js` (scheduled sync: lease, gate, CU budget, cursors, resume).
- Scheduling: job `wallets` in `jobs.js`; a one-minute check in `server.js` (Render and the PC dashboard); the PC's hourly task picks it up through `job run --all-due`.
- API routes, CLI (`wallet …`), Portfolio UI (holdings first, Wallets tab), doctor line, index attention items, backup record totals, offsite drill.
- Tests with fictional fixtures only.

## Results

**Tests.** Baseline before any change: 532 of 532. After: 551 of 551 (`node dashboard/cli.js test`), including `dashboard/tests/wallets.test.js` (19 tests, fictional fixtures, a stub Moralis, global fetch refused):

| Case | Test |
|---|---|
| Initial balances without invented purchases | first sync with no history |
| Buy, partial sale, full sale, transfer (exact to the wei) | buy, partial sale, full sale and transfer |
| Duplicate items, repeated sync, multiple events in one transaction | repeated syncs and duplicate items |
| Pagination interruption and restart from the saved cursor | an interrupted read resumes |
| Transfer between two tracked wallets; one decision for both views | two tracked wallets (two tests) |
| Failed transaction, reorganization before and after recording | failed transaction ... reorganized event |
| Spam, unverified token, missing price, dust, no research started | spam, unverified tokens ... |
| Rate limit (Retry-After), outage, key refusal, compute-unit budget | rate limits, outages ... |
| Manual-record overlap, possible move between own accounts, reconciliation mismatch with first-seen time | your own records ...; a send that may be a move ... |
| Exact quantities (6, 18 and 24 decimals) | exact quantities |
| Access control and viewing never syncs | the server ...; reading the wallet views ... |
| Secret and address exposure (logs, status, settings, errors, page data) | secrets and addresses ... |
| Backup, isolated restore, package; restored copy reads nothing | backup and an isolated restore; offsite drill (offsite.test.js) |

**UI.** Checked in the browser pane against `fixture.js` (demo workspace plus a fictional token and two fictional wallets, stub Moralis): Positions shows wallet balances first, then the ledger as "Recorded positions"; the Wallets tab shows decisions, per-network status, reconciliation with "since", activity with chain and ledger status, Add wallet, Sync settings and Technical details. 1440-class desktop and 375 px phone: no horizontal page scroll; decisions and network rows stack on a phone. Record in ledger and Sync now were exercised end to end. No console errors.

**Real workspace.** Untouched: `doctor` reports "No wallet is tracked, so nothing is read"; no `portfolio/wallets/` folder exists; no request was sent to Moralis from any desk.

## What works

- Add, pause, resume, change networks and remove tracking (history kept); Sync now joins the same queue.
- Scheduled reads on the online desk every 10 minutes per network (one-minute check in `server.js`; `job run wallets`), resumable cursors, one lease, Moralis's rate limit honored, failure backoff, a daily compute-unit budget reserved before each request.
- Ledger entries only for final, successful, supported, mapped activity; everything else visible with its reason; reversed events void their entries; reconciliation never adjusts the ledger.
- Doctor, the Render start log, the review queue, backups, packages and the offsite drill all cover the new records.

## Not supported yet

- Non-EVM addresses (Solana, Bitcoin), NFTs, and more than one provider.
- Bridges, staking, liquidity, lending, mints, burns and multi-token swaps are classified and shown, never recorded automatically.
- Tokens without a verified identity are shown (with "Price unavailable") but cannot enter the ledger; verifying the project (its chain and contract) makes their held activity recordable at the next sync.
- Rebasing tokens and rollup L1 data fees can leave a visible difference; it is shown, not corrected.
- Not checked against a live Moralis account: the adapter follows the documented v2.2 responses and was tested with fixtures shaped like them.

## Setup for Eric (when he decides to turn it on)

1. Create a Moralis API key on moralis.com (check the plan: compute units per day or month).
2. Render > CryptoResearch > Environment: add `MORALIS_API_KEY`. Never paste it into a chat.
3. Deploy (after review), then Portfolio → Wallets → Add wallet: label, the public 0x address, and the networks he actually uses.
4. If the plan allows less than about 24,000 compute units a day per network, raise the interval or set the budget under Sync settings.
