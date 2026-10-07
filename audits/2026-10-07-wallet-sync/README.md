# Read-only wallet sync (2026-10-07)

Status: the first version (Moralis) was committed as `0259aa4` and deployed on Eric's request; it was never enabled (no key, no wallet). The same day the provider was replaced with **Alchemy Free**, syncing twice daily, then reviewed adversarially before a live pilot (section "Adversarial review" below) and, on Eric's request, committed and pushed to `main` for Render to deploy. It reads nothing until `ALCHEMY_API_KEY` is set and Eric adds a wallet himself. The pilot (one wallet, one network) is recorded under "Live pilot" without the address or any amounts.

## Goal

Eric adds a public wallet address once (label, address, networks). The online desk follows it on its own schedule, so the Portfolio reflects buys, sales and transfers with the PC and browser closed. Read-only: no seed phrase, private key, signature, approval or spending permission is ever asked for or possible. A couple of automatic updates a day is enough.

## Provider: Alchemy (replacing Moralis)

Checked against Alchemy's documentation and pricing on 2026-10-07:

- **Free plan:** 30,000,000 compute units (CU) a month, 25 requests a second. The pricing page lists the Node API, Token API, Transfers API and Portfolio API as included on Free.
- **Transfers API** (`alchemy_getAssetTransfers`, 120 CU): documented for Ethereum and the L2s Base, Polygon, Arbitrum and Optimism. Categories `external`, `internal`, `erc20` (and NFT ones, not used). `internal` (ETH sent by contracts) only on Ethereum, Polygon and Base. Block timestamps (`withMetadata`) on all five. Ascending by block, paged by a `pageKey` that lives 10 minutes and belongs to the query that made it. `uniqueId` identifies one transfer. Amounts from `rawContract.value` and `rawContract.decimal` (hex); the float `value` is never used.
- **Token API:** `alchemy_getTokenBalances` (20 CU, pages of up to 100), `alchemy_getTokenMetadata` (10 CU).
- **Standard methods:** `eth_blockNumber` (10), `eth_getBlockByNumber` (20; the `finalized` tag), `eth_getBalance` (20), `eth_getTransactionReceipt` (20; `null` when the transaction is not in the chain), `eth_getTransactionCount` (counted 20 as an estimate).
- **Limits:** HTTP 429 past throughput, sometimes with Retry-After (honored); a JSON-RPC error 429 is handled the same way.
- **Portfolio API: evaluated, not used.** It costs 200 CU a call, can return HTTP 200 with partial per-network failures, and its prices would not be used; the per-network Token API gives the same balances for about 40 CU with one failure mode.
- **Networks offered:** Ethereum, Base, Polygon, Arbitrum One, Optimism. Linea, BNB Smart Chain and Avalanche are not in Alchemy's documented Transfers API coverage, so they are not offered; a wallet saved with one keeps its records and shows "Not read".
- No dependency, worker, wallet SDK, webhook or Supabase migration. Native `fetch`, one JSON-RPC endpoint per network built from a fixed host table; the key (`ALCHEMY_API_KEY`) is part of that URL and never leaves `core/alchemy.js`.

## What the sync does (per wallet and network, twice daily)

1. Head block and the chain's **finalized** block.
2. History window: from the last complete read minus an overlap (60 minutes of blocks; from block 0 the first time, a resumable backfill) to the head. Three queries, each paged to the end: every transaction the wallet sent (zero value included, for its fee); tokens out (and contract ETH out where offered); everything in. After each page the transfers and their **receipts** are saved and the place is kept (the block reached, and the live `pageKey`), so a restart, a cap or a page limit continues where it stopped.
3. When the window is complete: missing receipts and receipts of non-final transactions are asked again; the wallet's sent-transaction count (nonce) is compared with those seen; token metadata is read once per token; every transaction is classified from its legs and receipt and becomes final at the finalized block.
4. Balances: native and every token balance, every page, or no snapshot.
5. Ledger import, then reconciliation with first-seen times.

## Classification (evidence only)

| Activity | Evidence | Ledger |
|---|---|---|
| Received | value arrived in a transaction someone else sent; receipt succeeded | `transfer_in`, cost unknown |
| Sent | the wallet's own transaction: ETH to the recipient with no contract events, or a token's own transfer call with exactly one Transfer event | `transfer_out` |
| Between your wallets | the same, with the other side a tracked wallet | one `transfer_out` + `transfer_in` pair (lots move with their dates) |
| Network fee | receipt of a transaction the wallet sent: gas used × effective price, plus the L1 data fee on OP-stack networks and blob gas | `fee` in the native coin, once per transaction |
| Failed transaction | receipt status 0 | transfers never recorded; the fee is |
| Possible swap | the wallet's transaction, one asset out and another in | held for Eric: Record as swap (sale + purchase at unknown price) or Leave unrecorded |
| Deposits, bridges, staking, liquidity, claims, batch sends, value taken by a contract, multi-asset | anything else | unresolved, visible, never recorded |

Unverified tokens (no project identity names them) never enter the ledger. Alchemy gives no spam verdict; the desk sets aside an unverified token whose name advertises a link or a claim, or that arrived without the wallet doing anything, with the reason ("not a judgment that it is safe or unsafe"). Verified tokens and the native coin are never hidden, however small. Receiving a token never starts research.

Reversals need chain evidence: a reversal is recorded only when a transaction's receipt is gone **and** the block that held it now has another hash. Missing from one answer, a page or a window is never evidence; a receipt missing with the block unchanged stays pending. Only final events are recorded, so a recorded entry is voided (with the evidence, never deleted) only if that evidence ever appears for it.

## Records

Unchanged in principle: the ledger (`portfolio/transactions.json`) is the one authoritative record of holdings and cost; the files under `portfolio/wallets/` are the evidence (events with Alchemy's raw transfers and receipts by month, balance snapshots, token metadata) and Eric's choices (registry); reconciliation is derived on read. Records the Moralis version saved (none exist anywhere) would be kept with their provenance; a leg both providers saw is matched and never counted twice (tested).

## Usage and caps

| Per network, no new activity | CU |
|---|---|
| head + finalized block | 30 |
| three transfer queries | 360 |
| sent-transaction count | 20 |
| native + token balances | 40 |
| **per sync** | **450** |

One wallet on one network, twice daily: **about 900 CU a day, about 27,000 a month** (0.09% of the Free plan's 30,000,000), plus 20 per new transaction (its receipt) and 10 per new token (once). A first backfill adds about 360 per 1,000 transfers plus 20 per transaction (a wallet with 500 transactions: about 10,000 CU). The desk counts these as an **estimate** before each request (retries and pages included) and stops before its own caps: 200,000 a day and 2,000,000 a month by default (about 7% of Free), editable in Wallets → Sync settings. Alchemy's dashboard is the provider's record. Interval choices: twice daily (default), once daily, every 6 or 3 hours, every hour; nothing shorter is accepted.

## Results

**Tests.** Before the Alchemy change: 551 of 551. After it: 557 of 557; after the adversarial review: **563 of 563** (`node dashboard/cli.js test`). `dashboard/tests/wallets.test.js` has 31 tests against a stub Alchemy that speaks its JSON-RPC shapes (strict about pageKeys, like Alchemy), fictional data, global fetch refused; the six added by the review are described under "Adversarial review". The first 25:

| Case | Test |
|---|---|
| Balances (native + tokens, exact), no invented purchase, metadata cached | first sync with no history |
| Buy / partial sale / full sale as possible swaps decided by Eric, plain send, fees once per transaction, exact to the wei | buy, partial sale, full sale and send |
| Several transfers in one transaction, one fee, batch send unresolved, self-transfer read twice counted once, duplicate items, repeated syncs | one transaction with several transfers |
| Pagination interrupted, restart, expired pageKey not reused, exact pageKey parameters | pagination interrupted |
| Between tracked wallets; one decision for both views | two tracked wallets (two tests) |
| Receipts: failed transaction, OP-stack L1 fee | receipts decide success |
| Reversal only on evidence; missing row and unchanged block are not reversals; void with evidence | reversals need chain evidence |
| Unverified, suspicious, unsolicited tokens; small verified holding stays; missing price; no research | unverified tokens |
| Daily and monthly caps (retries counted), outage, HTTP 429 + Retry-After, JSON-RPC 429, key refused, plan used up | caps ...; a cap stops the run |
| Unsupported networks never read | unsupported networks |
| Manual overlap, possible move to an exchange, mismatch with first-seen time | your own records ...; a held transfer ... |
| Exact quantities 6/18/24 decimals, hex parsing, float never used | exact quantities |
| Arbitrum history without contract ETH ("history partial"), nonce check | history coverage |
| Usage estimate | usage |
| Sync now, pause, remove, re-add | Sync now ... |
| Jobs due only with Alchemy key; Moralis key alone does nothing; restored copy held | jobs |
| Key, endpoint URL and address never in logs, status, settings, errors, the page or the assistant connector (ChatGPT's connection asked `list_accounts`, `portfolio_overview`, `desk_status`) | secrets ... |
| Backup, isolated restore, package; restored copy sends nothing | backup ... |
| Server token, origin, viewing sends nothing | the server ...; reading the views ... |
| Earlier-provider records kept, never doubled | records the earlier provider saved |
| Classification reads only evidence | classification ... |

A real bug found by these tests and fixed: following Alchemy's pageKey with a moved `fromBlock` skipped transfers. A live pageKey is now always sent with its query's own parameters; the block reached is used only to start a fresh query after the key expires.

**UI.** After the review, the "history incomplete" state was checked at 375 px with the same fixture (a sent-transaction gap pinned on MetaMask's Ethereum): "Synced just now · history incomplete" with its amber dot and the line naming the missing transactions, no horizontal scroll. Earlier, checked in the browser pane with `fixture.js` (demo workspace, a fictional token, three fictional wallets, stub Alchemy): at desktop and 375 px, Positions shows wallet balances first with "Syncs twice daily", a stale network ("Stale · last complete sync 30 h ago"), an unsupported network ("Not read: Alchemy's transfer history does not cover this network"), a network whose history is loading ("History still loading (block … of …)"), unverified tokens set aside with their reasons, and "Price unavailable". The Wallets tab shows the possible swap once with both legs and "Record as swap / Leave unrecorded", per-network rows (including "History here does not include ETH sent by contracts" on Arbitrum), reconciliation, and "Sync settings · Twice daily". No horizontal page scroll at 375 px; no console errors.

**Real workspace.** Untouched: no wallet, no `portfolio/wallets/` folder, no request to Alchemy or Moralis from any desk.

## Adversarial review before the pilot (2026-10-07)

The diff was read again against six questions, each answered by a test that fails when its fix is undone (checked by undoing every fix in turn: all twelve caught).

1. **Failed transactions with no transfer events.** A failed transaction Alchemy lists (as a zero-value or value transfer from the wallet) gets its receipt, and its fee is recorded once; its transfer never is. Alchemy does not document whether its history includes failed transactions (an open issue on its SDK tracker reports that it does), so the desk does not rely on it: every sync compares the wallet's sent-transaction count on chain (`eth_getTransactionCount` at the block read) with the transactions on record. A shortfall labels the network "Synced · history incomplete (n sent transaction(s) not in Alchemy's history)", the native coin's reconciliation "History partial" with that note, and a review item. Nothing is guessed for the missing fees. A nonce search that would find such transactions without an indexer (about 600 compute units each) is a possible later step, not built.
2. **Pagination, in/out overlap and restarts.** Events are keyed by network and Alchemy's `uniqueId`, the same in every query, so a self-transfer, a repeated item, an overlap re-read or a restarted page is one event. A live pageKey is sent only with its own query; after it expires the read restarts at the last block reached (inclusive). New test: page sizes 1, 2 and 3, both attempts of every fifth transfers request failing, the page limit and the receipt limit stopping runs, pageKeys alternately live and expired; after up to 120 runs every event, classification and ledger entry equals one clean read.
3. **Gas once, with L1 fees.** One fee event per transaction the wallet sent (`<network>:<hash>:fee`), from the receipt: gas used × effective price, plus `l1Fee` on Base and Optimism and blob gas on Ethereum (Arbitrum's L1 part is inside its gas used). Fixed: a deposit bridged in from Ethereum (OP-stack type `0x7e`) was read as a self-transfer; it is now unresolved and has no fee here. A receipt naming a non-zero OP-stack operator fee (zero on standard chains; its formula changed between upgrades) leaves that fee unknown and unrecorded rather than guessed.
4. **Missing or partial answers never void entries.** Fixed: a token transfer answered without its contract address counted as "different content" and would have voided a recorded entry; it is now a malformed item and ignored. Fixed: an answer that is not the requested receipt was read as "receipt gone"; only a `null` answer counts, and a block check counts only a block answered at that height. Fixed: a node answering an older finalized block could put final events back to pending; finality now never goes back, and a head block behind the history already read is a failed try that reads nothing.
5. **An approved swap is recorded once.** It becomes one sale and one purchase (prices unknown) and its two transfers are never recorded as well; later reads and imports add nothing (tested three times over). Fixed: if Alchemy later reports another amount for one side, both sides' entries are voided together (kept, with the reason) and the swap is asked again, where before one side kept pointing at voided entries and the import could fail.
6. **Keys and addresses.** The key lives only in the endpoint URL inside `core/alchemy.js`. Fixed: Alchemy's error text is now scrubbed of URLs, the key and any address before it reaches status, logs or replies; a wallet label that contains an address is refused (labels appear in logs). The connector's `list_accounts`, `portfolio_overview` and `desk_status` carry no address; the start log has counts and states only.

Also fixed: token details that failed once were cached as unreadable for good, keeping that token's transfers out of the ledger; they are asked again at most once a day (10 compute units each), and an event not recorded for a reason that has since gone (amount now known) is looked at again. Receipts are asked per page only for that page's transactions (the rest once per window), not again on every page.

## What works, and what does not

Works on Ethereum, Base, Polygon, Arbitrum One and Optimism: native and ERC-20 balances; received transfers; plain sends; transfers between tracked wallets; network fees (with the L1 fee on Base and Optimism); failed transactions Alchemy lists; possible swaps on Eric's decision; reconciliation, overlap holds, pause, remove, Sync now; backup and restore.

History is never called complete on the desk's own say-so: a read is complete to a block, and whether it holds everything is checked two ways, the sent-transaction count and the balance reconciliation. Known gaps, each said on screen: sent transactions Alchemy does not list (their fees); ETH sent by contracts on Arbitrum One and Optimism; tokens whose balance changes without a Transfer event (WETH wrap and unwrap, rebasing and interest-bearing tokens); deposits bridged in on Base and Optimism (unresolved).

Unresolved or unsupported: bridges, staking, liquidity, lending, claims, batch sends and multi-asset transactions (visible, not recorded); NFTs; Linea, BNB Smart Chain, Avalanche, Solana and Bitcoin; tokens without a verified identity (shown, never recorded).

## Live pilot

One wallet on one network, added by Eric. What is checked, with results stated without the address or amounts: the first sync completes (history, receipts, balances); Sync now twice more adds no event and no ledger entry; the balances and several transactions match the block explorer; the sent-transaction count matches or its gap is said; compute units (the desk's estimate, and Alchemy's dashboard if Eric reads it).

Result: waiting for Eric to add the wallet.

## Setup for Eric (when he decides to turn it on)

1. In the Alchemy dashboard (alchemy.com), sign up on the Free plan and create an app; copy its API key. Do not add a payment method or enable pay-as-you-go.
2. Render > CryptoResearch > Environment: add `ALCHEMY_API_KEY` with that key and save (Render restarts the desk). Remove `MORALIS_API_KEY` if it was ever added (it is no longer used). Never paste a key into a chat.
3. Portfolio → Wallets → Add wallet: a label (a name, not the address), the public 0x address, and one network for the pilot. The first read starts within a minute, then twice daily.
4. The first live check: the Wallets tab after the first read; Technical details show the history read, the finalized block, the sent-transaction count and the estimated compute units, which can be compared with Alchemy's dashboard.
