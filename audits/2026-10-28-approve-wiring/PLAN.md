# Slot 12: Approve opens a paper order in `cr-paper@2`

PLAN for Eric's approval, 2026-10-28. No code is written until he approves. This is the last slot of the supervised blueprint, after D11 (#82) and D12 (#83).

## What it would do

When Eric approves or halves a ticket, the desk also turns that ticket into one `cr.trade-intent.v3` order. It puts the order through the trader's Paper Book (`cr-paper@2`): reserve, send to the book's own simulated venue, and record the answer.

Each closed hour, the desk applies that token's hourly candle to the book. The candle fills the order, partly or in full, and hits its stop or its target. Outcomes shows the result.

The order never leaves the desk. Nothing moves money, connects a wallet or exchange, or signs anything.

## Decision 1: where the hourly candles come from (the blocker)

The desk keeps about one CoinGecko price per hour plus a rolling 24-hour volume (`market-data/observations`). It has no hourly high, low or volume. `cr-paper@2` needs all three: the high and low for stops and targets, and the volume for partial fills (at most 10% of an hour's volume fills).

**A. GeckoTerminal's public pool candles (recommended).**
- I made one keyless read on 2026-10-28: `GET api.geckoterminal.com/api/v2/networks/{network}/pools/{pool}/ohlcv/hour`. It returned closed hours as `[time, open, high, low, close, volume]`, priced in USD.
- **Caveats:**
  - Its API guide now redirects to CoinGecko's paid on-chain docs, and the public API was labeled beta, so it may change or close.
  - The rate limit is 30 calls a minute per its FAQ as found by search; I did not re-confirm the number.
  - It would be a new outside call from the server, through the same guarded HTTPS as the exit quotes (`netguard.js`). Only the network and pool address are sent.
- **How the desk would read it:**
  - One pool per order: the verified contract's deepest pool on its chain, chosen at Approve and frozen on the order, so the candles never switch pools.
  - Only closed hours are used. A missing hour stops that pair: the book refuses gaps.
  - Volume comes in USD, and the book counts token units, so it is converted at the hour's high. That gives the fewest units, the cautious reading.
  - Native coins (BTC, ETH, SOL) have no single pool. They are left out at first, as with exit quotes.

**B. Candles built from the desk's own hourly price.** Not recommended.
- Open would be the previous reading, close this one, and high and low the two of them.
- Wicks are missed, so stops fire late and fills look easier than they were. With no hourly volume there are no partial fills.
- It changes the book's fill rules, so it would be a new version, `cr-paper@3`.

**C. Wait.** Approve keeps opening `cr-paper@1` only.

## Decision 2: how a ticket becomes an order

Only an ACCUMULATE or LIMIT_TRAP ticket opens anything. TRIM_EXIT, WATCH_ONLY and HARD_PASS never do.

| Order field | From the ticket | When it is missing |
|---|---|---|
| Entry (a limit) | ACCUMULATE: the lower of the current price and `entry_zone.high_usd`. LIMIT_TRAP: `entry_zone.low_usd` | No order, said in words |
| Stop | `invalidation_trigger.price_usd`, which must pass your minimum stop distance | No order. A stop is never invented, so a metric-only invalidation opens nothing |
| Target | `upside_target.price_usd` | No order |
| Risk | Your decision: Approve $500, Halve $250 | n/a |
| Life | Your longest life of an intent (up to 7 days). Unfilled at the end, it expires; it is never re-issued | Every order refused until you set it |
| Pair | `SYMBOL/USDC`, which must be on your allowlist. Refused while another unarchived desk project shares the symbol | Refused |

What this means with the desk's current limits:
- **Funding.** The engine caps risk at 2% of the book's NAV. A $500 approval needs a book of at least $25,000.
  - My recommendation is to fund it at $25,000 once. Then Approve is exactly 2% and Halve 1%.
  - The other way is to cut the order to 2% of whatever you fund, so on $10,000 a $500 approval becomes $200.
  - At $25,000, the 24-hour ceiling (4%, $1,000, counting what is already at the stops) allows two $500 trades open at once.
- **The exit cap (D11).** The book never buys more than the largest size the ticket's exit readings showed selling within 5%. On the default ladder ($100, $500, $2,000) that is at most $2,000 of token.
  - A $500 risk fits under $2,000 only with a stop about 24% or more below the entry. A $250 risk needs about 12%.
  - Tighter stops are refused (`exit_cap`) unless you add a larger size, such as $5,000, to the ladder in Preferences > Screening.
- **Freshness (D11).** The exit readings must be no older than 72 hours when the order is made. Approving a ticket more than three days after it was written is refused until the exits are quoted again.

## Decision 3: the current paper book (`cr-paper@1`)

**Keep it running unchanged beside `cr-paper@2` (recommended).**
- `@1` measures your decision itself: the risk as the position, priced from the hourly readings, closed at the horizon or the invalidation price.
- `@2` measures what an order would actually have done: fills, fees, slippage, stops.
- Outcomes shows both, labeled, never added together.
- Retiring `@1` would be your call later, for example after a month of `@2` records.

## Smaller choices (my defaults unless you say otherwise)

- **Undo or veto after Approve.** Whatever has not filled is cancelled. Anything that filled is closed with a sell order at the next hour. The trade happened, so it is closed, never erased.
- **Horizon end.** A sell order when the ticket's horizon ends. A metric invalidation the desk detects closes it the same way.
- **Venue fees.** Your setting, with no default. An unknown fee refuses the order, never 0. A typical DEX pool charges 0.3%; you would enter it.
- **Lot and minimum size.** A lot of 0.000001 token and a $10 minimum, fixed in code and stated on every order.
- **Which desk.** Whichever desk you approve on, usually the online desk from your phone. The book lives on that desk's disk.

## What would be built, after your approval

Each item is its own branch and pull request, `node dashboard/cli.js test`, and your merge.

1. **12a [P].** One adapter module, `dashboard/core/trader-desk.js`, the only caller of the trader:
   - Approve and Halve turn the ticket into the order.
   - Undo and Veto cancel or close.
   - The decision's effects line gains a `trader` entry, idempotent like `paper`.
   - `trader-boundary.test.js` allows exactly this one caller.
   - No network.
   - Fictional tests, including one real-shaped ticket from approval to stop.
2. **12b.** The hourly candle read (option A):
   - It runs on the desk's existing 30-minute job timer, with no new scheduler and nothing in CI.
   - It has its own call budget, a 429 gate and back-off, like the exit quotes.
   - It is held in a restored copy.
3. **12c.** Outcomes > Paper Book shows the `@2` book read-only: positions, orders with their state in words, NAV by the hour, realized P&L, and each refusal with its reason.
4. **Your one-time steps.** These are settings, not code: set the funding, the trader rules (minimum stop distance, notional cap, longest life, allowlist) and the venue fee.

## What stays true

- The engine's hard limits (2% per trade, 4% per 24 hours, a stop on every order, the allowlist) are unchanged.
- The model never picks an amount, and a refusal is always given in words.
- Nothing here places a real order, holds a key or touches Portfolio.
